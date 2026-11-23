// PitthuRoom — Cloudflare Durable Object: ONE object per room code.
//
// This is the ONLY authoritative multiplayer simulation. It replaces the old
// HTTP-polling sync (client POSTed /api/room every 90ms, server did a full
// D1 SELECT + JSON.parse + UPDATE with revision optimistic locking per
// input, so concurrent players collided with 409s and the game only advanced
// when a request happened to arrive).
//
// New architecture (v3 — see NETCODE_FIX.md):
//  * Room state lives IN MEMORY in this object (this.game), not in D1.
//  * Clients connect over WebSocket and send inputs fire-and-forget.
//  * A server-side 20 Hz tick — a guarded in-memory setInterval(),
//    fixed 50 ms steps on a synthetic clock — calls advance() and
//    broadcasts to every connected socket. No client ever waits for a
//    reply to its input, and there is no revision race: inputs are
//    applied serially inside this single object.
//  * alarm() is NOT the tick loop any more (v2 used it; every setAlarm
//    is a durable storage write with best-effort timing, so ticks
//    stalled). It is only a 60 s watchdog: if the interval ever dies
//    while players are connected, the alarm restarts it.
//  * The tick path does ZERO I/O: no setAlarm, no awaited D1 write.
//    D1 checkpoints go through ctx.waitUntil() on discrete events
//    (create/start/round end/lobby/leave) and at most once per 10 s.
//  * D1 is only a backup: the lobby (create/join) is still created in
//    D1 by /api/room, this object hydrates from D1 on first use, and it
//    checkpoints back so a DO eviction can re-hydrate.
//  * Broadcasts are compact tick updates (quantized arrays, no static
//    fields) 20x/sec, with a full publicState() only on discrete
//    transitions (hello, event/phase/round/scores change). Every
//    broadcast carries `ack` (lastProcessedSeq per player) so clients
//    can replay only their unacknowledged inputs.
//
// Wiring: vite.config.ts binds this class as PITTHU_ROOM
// (durable_objects + migrations tag v1), worker/index.ts routes
// /ws and /api/room/ws upgrades to idFromName(code), and
// cloudflare-env.d.ts declares PITTHU_ROOM: DurableObjectNamespace.
//
// Protocol (all messages are JSON):
//   Client -> server: {type:'input', input:{seq,round,mx,mz,ax,az,
//                       interact,charging,charge,action}}
//   Client -> server: {type:'op', op:'config'|'switchTeam'|'start'|
//                       'lobby'|'leave'|'join', ...lobby fields}
//   Client -> server: {type:'leave'} | {type:'ping'}
//   Server -> client: {type:'hello', revision, tick, serverTime, ack, state}
//   Server -> client: {type:'state', revision, tick, serverTime, ack, state}
//   Server -> client: {type:'tick', tick, serverTime, ack, ...compact}
//   Server -> client: {type:'error', error}
//   Server -> client: {type:'pong'}
// Auth is the same token scheme as /api/room: ?code=XXXXXX&token=<uuid>
// on the WS URL, or token in an 'op'/'input' message body. Tokens are
// never included in the broadcast state (publicState strips them).

import {
  player,
  start,
  command,
  advance,
  publicState,
  clamp,
  normalizeTeamSizes,
} from '../lib/game.js';
import { createInputQueue, queueInput, drainInputs, compactTick } from '../lib/netcode.js';

const TICK_MS = 50; // v3: 20 Hz fixed server tick, 1:1 with the 20 Hz client input
const CHECKPOINT_MS = 10_000; // at most one D1 checkpoint per 10 s
const WATCHDOG_MS = 60_000; // alarm() watchdog interval (recovery only)
const ROOM_TTL_MS = 7_200_000; // 2 h, same as /api/room
const VALID_OPS = new Set(['join', 'config', 'switchTeam', 'start', 'lobby', 'leave']);

function sanitizeName(raw: unknown): string {
  // Strip control chars, zero-width chars, BOM and angle brackets by
  // code point (avoids literal control characters in this source file).
  const s = String(raw || 'Neighbour')
    .split('')
    .filter((ch) => {
      const c = ch.codePointAt(0) || 0;
      return (
        c >= 0x20 &&
        !(c >= 0x7f && c <= 0x9f) &&
        !(c >= 0x200b && c <= 0x200d) &&
        c !== 0xfeff &&
        ch !== '<' &&
        ch !== '>'
      );
    })
    .join('')
    .trim()
    .slice(0, 16);
  return s || 'Neighbour';
}
function sanitizeLook(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(7, Math.floor(n))) : 0;
}

// Same input sanitising + anti-cheat charge bound as /api/room used to do.
function sanitizeInput(raw: any, g: any, me: any): any {
  const safe: any = {
    seq: raw.seq,
    round: raw.round,
    mx: raw.mx,
    mz: raw.mz,
    ax: raw.ax,
    az: raw.az,
    interact: !!raw.interact,
    charging: !!raw.charging,
    charge: raw.charge,
    action: typeof raw.action === 'string' ? raw.action.slice(0, 12) : '',
  };
  if (Number.isFinite(safe.charge)) {
    const rate = me.buff === 'banta' ? 4.6 : 1.65;
    // elapsedSec is ~one tick here; the +0.28 s jitter allowance is kept
    // from the old route so a legitimately charged throw is never clipped.
    const maxPossibleCharge =
      g.ball?.holder === me.id ? clamp((me.held + TICK_MS / 1000 + 0.28) * rate, 0.08, 1) : 0;
    safe.charge = clamp(Number(safe.charge), 0, maxPossibleCharge);
  }
  return safe;
}

export class PitthuRoom {
  private ctx: any;
  private env: any;
  private game: any = null;
  private code: string = '';
  private revision: number = 0;
  private tick: number = 0;
  private inputQueue: any = createInputQueue();
  private sockets: Set<any> = new Set();
  private socketPlayer: Map<any, string> = new Map();
  private tickTimer: any = null; // v3: guarded in-memory interval (see startTickLoop)
  private tickNow: number = 0; // synthetic tick clock (ms) — fixed 50 ms steps
  private lastCheckpoint: number = 0;
  private dirty: boolean = false;
  private lastBroadcastEvent: number = -1;
  private lastBroadcastPhase: string = '';
  private lastBroadcastRound: number = -1;
  private lastBroadcastScores: string = '';
  private lastBroadcastPowerups: string = '';
  private lastBroadcastDecoys: string = '';

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  // ---- D1 hydration / checkpoint (backup only, never per tick) ----

  private async ensureLoaded(code: string): Promise<any> {
    if (this.game) return this.game;
    this.code = code;
    if (!this.env.DB) return null;
    const row = await this.env.DB.prepare(
      'SELECT state,revision,updated FROM rooms WHERE code=?',
    )
      .bind(code)
      .first()
      .catch(() => null);
    if (!row || Date.now() - row.updated > ROOM_TTL_MS) return null;
    this.game = JSON.parse(row.state);
    this.revision = row.revision || 0;
    this.game.last = Date.now();
    return this.game;
  }

  private async checkpoint(force = false): Promise<void> {
    if (!this.game || !this.code || !this.env.DB) return;
    const now = Date.now();
    if (!force && now - this.lastCheckpoint < CHECKPOINT_MS) return;
    this.lastCheckpoint = now;
    await this.env.DB.prepare(
      'UPDATE rooms SET state=?,revision=?,updated=? WHERE code=?',
    )
      .bind(JSON.stringify(this.game), this.revision, now, this.code)
      .run()
      .catch(() => {});
  }

  // D1 checkpoints never block the tick: they run through waitUntil()
  // on discrete events, throttled to once per 10 s. (v2 awaited
  // checkpoint() inside alarm(); the throttle already limited real
  // writes to 1/10 s, but the tick still awaited the check — v3 removes
  // even that from the tick path.)
  private checkpointSoon(): void {
    if (!this.game || !this.code || !this.env.DB) return;
    const now = Date.now();
    if (now - this.lastCheckpoint < CHECKPOINT_MS) return;
    this.lastCheckpoint = now;
    try {
      this.ctx.waitUntil(this.checkpoint(true));
    } catch {
      /* waitUntil unavailable (local dev) — checkpoint is best-effort */
    }
  }

  // ---- tick & broadcast (v3: in-memory setInterval, alarm = watchdog) ----

  private startTickLoop(): void {
    // Guard: reconnects / simultaneous joins must never start two
    // overlapping intervals (that would double the game speed).
    if (this.tickTimer || !this.game) return;
    this.tickNow = Date.now();
    this.game.last = this.tickNow;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    // Watchdog: if the interval ever dies (isolate restart) while
    // players are connected, alarm() restarts it within 60 s.
    try {
      this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS).catch(() => {});
    } catch {
      /* no storage in local dev */
    }
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // Watchdog / cleanup only — NOT the tick loop (v2 used alarm() per
  // tick; every setAlarm is a durable storage write with best-effort
  // timing, so ticks stalled).
  async alarm(): Promise<void> {
    if (!this.game || this.sockets.size === 0) {
      // No players left: checkpoint once and stop ticking until someone returns.
      await this.checkpoint(true);
      return;
    }
    // Recovery: restart the interval if it died, and re-arm the watchdog.
    if (!this.tickTimer) this.startTickLoop();
    else {
      try {
        this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS).catch(() => {});
      } catch {
        /* no storage in local dev */
      }
    }
  }

  private tick(): void {
    if (!this.game || this.sockets.size === 0) {
      this.stopTickLoop();
      return;
    }
    const phase = this.game.phase;
    if (phase === 'opening' || phase === 'chase' || phase === 'result') {
      // Inputs are applied ONLY here, at the tick boundary, in
      // per-player seq order — never on WS arrival. Applying on arrival
      // made movement depend on network jitter (two inputs 5 ms apart
      // moved the player by different amounts) and let an action
      // broadcast overtake the previous tick's state.
      for (const { playerId, input } of drainInputs(this.inputQueue)) {
        const pl = this.game.players.find((q: any) => q.id === playerId);
        if (pl) command(this.game, playerId, sanitizeInput(input, this.game, pl));
      }
      this.tick++;
      // Fixed 50 ms step on the synthetic clock: advance() sub-steps at
      // 1/30 s internally, so a 50 ms tick is 1/30 + 1/60 — deterministic
      // and independent of wall-clock jitter. (v2 passed Date.now().)
      this.tickNow += TICK_MS;
      advance(this.game, this.tickNow);
      this.revision++;
      this.broadcast();
      this.checkpointSoon();
    } else {
      // Lobby / match: nothing to simulate; broadcast only if something changed.
      if (this.dirty) {
        this.dirty = false;
        this.revision++;
        this.broadcast();
        this.checkpointSoon();
      }
    }
  }

  private ackMap(): Record<string, number> {
    // lastProcessedSeq per player = the seq command() last applied for
    // them (game.js stores it on the player). Clients replay only
    // inputs with seq > ack.
    const ack: Record<string, number> = {};
    for (const p of this.game.players) ack[p.id] = p.seq || 0;
    return ack;
  }

  private broadcast(): void {
    if (!this.game) return;
    const g = this.game;
    const scoresKey = `${g.scores?.[0] ?? 0},${g.scores?.[1] ?? 0}`;
    const powerupsKey = (g.powerups || []).map((pu: any) => pu.uid || pu.id).join(',');
    const decoysKey = (g.decoys || []).map((dc: any) => dc.id).join(',');
    // Full state on hello-adjacent transitions (event/phase/round/
    // scores change, or a powerup/decoy spawns/despawns — those carry
    // display fields the tick only partially repeats); compact tick
    // updates otherwise. The tick carries everything that changes per
    // tick; static fields (names, teams, looks, teamSizes) come from
    // the last full state on the client.
    const full =
      g.event !== this.lastBroadcastEvent ||
      g.phase !== this.lastBroadcastPhase ||
      g.round !== this.lastBroadcastRound ||
      scoresKey !== this.lastBroadcastScores ||
      powerupsKey !== this.lastBroadcastPowerups ||
      decoysKey !== this.lastBroadcastDecoys;
    this.lastBroadcastEvent = g.event;
    this.lastBroadcastPhase = g.phase;
    this.lastBroadcastRound = g.round;
    this.lastBroadcastScores = scoresKey;
    this.lastBroadcastPowerups = powerupsKey;
    this.lastBroadcastDecoys = decoysKey;
    const ack = this.ackMap();
    const msg = full
      ? JSON.stringify({
          type: 'state',
          revision: this.revision,
          tick: this.tick,
          serverTime: Date.now(),
          ack,
          state: publicState(g),
        })
      : JSON.stringify(compactTick(g, this.tick, Date.now(), ack));
    for (const ws of [...this.sockets]) {
      try {
        if (ws.readyState === 1) ws.send(msg);
      } catch {
        this.sockets.delete(ws);
        this.socketPlayer.delete(ws);
      }
    }
  }

  private send(ws: any, obj: any): void {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }

  // ---- leave / disconnect: same policy as the old route ----

  private handleLeave(playerId: string): void {
    const g = this.game;
    if (!g) return;
    const me = g.players.find((p: any) => p.id === playerId);
    if (!me) return;
    const otherHumans = g.players.filter((p: any) => !p.bot && p.id !== playerId);
    if (['opening', 'chase', 'result'].includes(g.phase) && otherHumans.length > 0) {
      // Preserve the active match: departing player becomes a bot.
      me.bot = true;
      delete me.token;
      if (g.host === playerId) g.host = otherHumans[0].id;
    } else {
      g.players = g.players.filter((p: any) => p.id !== playerId && !p.bot);
      if (g.host === playerId) g.host = g.players[0]?.id || '';
      g.phase = 'lobby';
    }
    g.event = (g.event || 0) + 1;
    this.dirty = true;
  }

  // ---- lobby ops over WS / HTTP-forwarding (single authority) ----
  // Adapted from app/api/room/route.ts; operates on this.game only —
  // no D1 read/write, no revision loop, no 409 retry.

  private doOp(op: string, body: any): any {
    const g = this.game;
    if (!g) throw new Error('That room has expired or does not exist.');
    const tok =
      typeof body.token === 'string' && body.token.length > 0 && body.token.length <= 64
        ? body.token
        : '';
    const name = sanitizeName(body.name);
    const look = sanitizeLook(body.look);
    let me = tok ? g.players.find((p: any) => !p.bot && p.token === tok) : null;
    const issued: any = {};

    if (op === 'join') {
      if (me) {
        if (g.phase === 'lobby') {
          me.name = name;
          const taken = new Set(g.players.filter((p: any) => p.id !== me.id).map((p: any) => p.look));
          me.look = taken.has(look)
            ? [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !taken.has(c)) ?? look
            : look;
        }
        issued.id = me.id;
        issued.token = me.token;
      } else {
        if (g.phase !== 'lobby')
          throw new Error('This match has started. Join when the host returns to the lobby.');
        const ts = normalizeTeamSizes(g.teamSizes, [3, 3]);
        g.teamSizes = ts;
        const humans = g.players.filter((p: any) => !p.bot);
        if (humans.length >= ts[0] + ts[1]) throw new Error('This courtyard is full.');
        const t0 = humans.filter((p: any) => p.team === 0).length;
        const t1 = humans.length - t0;
        const canT0 = t0 < ts[0];
        const canT1 = t1 < ts[1];
        const assignedTeam =
          canT0 && canT1 ? (t0 / ts[0] <= t1 / ts[1] ? 0 : 1) : canT0 ? 0 : 1;
        const taken = new Set(humans.map((p: any) => p.look));
        const uniqueLook = taken.has(look)
          ? [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !taken.has(c)) ?? look
          : look;
        me = { ...player(crypto.randomUUID(), name, assignedTeam), token: crypto.randomUUID(), look: uniqueLook };
        g.players.push(me);
        if (!g.host || !g.players.some((p: any) => !p.bot && p.id === g.host)) g.host = me.id;
        issued.id = me.id;
        issued.token = me.token;
      }
      this.dirty = true;
      return { state: publicState(g), ...issued };
    }

    if (!me) throw new Error('Your session has ended. Join again.');

    if (op === 'config') {
      if (g.host !== me.id) throw new Error('Only the host can change match size.');
      if (g.phase !== 'lobby') throw new Error('Match size can only be changed in the lobby.');
      const nextSizes = normalizeTeamSizes(body.teamSizes, g.teamSizes || [3, 3]);
      const humans = g.players.filter((p: any) => !p.bot);
      if (humans.length > nextSizes[0] + nextSizes[1])
        throw new Error(
          `${humans.length} players are in the room—increase team slots to fit everyone.`,
        );
      g.teamSizes = nextSizes;
      for (const t of [0, 1]) {
        const other = 1 - t;
        const tPlayers = humans.filter((p: any) => p.team === t);
        while (tPlayers.length > nextSizes[t]) {
          const moved = tPlayers.pop();
          if (moved && humans.filter((p: any) => p.team === other).length < nextSizes[other])
            moved.team = other;
        }
      }
      g.event = (g.event || 0) + 1;
    } else if (op === 'switchTeam') {
      if (g.phase !== 'lobby') throw new Error('You can only switch teams in the lobby.');
      const ts = normalizeTeamSizes(g.teamSizes, [3, 3]);
      const targetTeam = me.team === 0 ? 1 : 0;
      const targetCount = g.players.filter((p: any) => !p.bot && p.team === targetTeam).length;
      if (targetCount >= ts[targetTeam])
        throw new Error(
          `Team ${targetTeam ? 'Coral' : 'Teal'} is already full (${ts[targetTeam]}/${ts[targetTeam]}).`,
        );
      me.team = targetTeam;
      g.event = (g.event || 0) + 1;
    } else if (op === 'start') {
      if (g.host !== me.id) throw new Error('Only the host can start.');
      if (!['lobby', 'match'].includes(g.phase)) throw new Error('A round is already playing.');
      if (body.teamSizes) g.teamSizes = normalizeTeamSizes(body.teamSizes, g.teamSizes || [3, 3]);
      else g.teamSizes = normalizeTeamSizes(g.teamSizes, [3, 3]);
      g.players = g.players.filter((p: any) => !p.bot);
      if (body.fill === false) {
        const c0 = g.players.filter((p: any) => p.team === 0).length;
        const c1 = g.players.filter((p: any) => p.team === 1).length;
        if (c0 < 2 || (c1 < 2 && g.players.length >= 4)) {
          const target0 = clamp(Math.min(g.teamSizes[0], g.players.length - 2), 2, 4);
          g.players.forEach((p: any, idx: number) => {
            p.team = idx < target0 ? 0 : 1;
          });
        }
      }
      start(g, body.fill !== false, g.teamSizes);
      // Keep the synthetic tick clock authoritative when the loop runs;
      // Date.now() only when the loop is not running yet (lobby).
      g.last = this.tickTimer ? this.tickNow : Date.now();
    } else if (op === 'lobby') {
      if (g.host !== me.id) throw new Error('Only the host can reset.');
      g.phase = 'lobby';
      g.players = g.players.filter((p: any) => !p.bot);
    } else if (op === 'leave') {
      this.handleLeave(me.id);
      return { state: publicState(g), ...issued };
    } else {
      throw new Error('Unsupported room operation.');
    }
    this.dirty = true;
    return { state: publicState(g), ...issued };
  }

  // ---- HTTP entry point (called by worker/index.ts) ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code))
      return Response.json({ error: 'Enter a six-character room code.' }, { status: 400 });

    // Internal status check used by /api/room to decide whether the DO
    // already owns this room (and HTTP lobby ops should be forwarded).
    if (url.pathname.endsWith('/loaded')) {
      return Response.json({ loaded: !!this.game, code });
    }

    // Internal op forwarding from /api/room (lobby ops from clients that
    // have not opened a WebSocket yet). Hydrates from D1 on first use.
    if (url.pathname.endsWith('/op')) {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Malformed request payload.' }, { status: 400 });
      }
      const op = String(body.op || '');
      if (!VALID_OPS.has(op))
        return Response.json({ error: 'Unsupported room operation.' }, { status: 400 });
      const g = await this.ensureLoaded(code);
      if (!g)
        return Response.json(
          { error: 'That room has expired or does not exist.' },
          { status: 404 },
        );
      try {
        const out = this.doOp(op, body);
        this.broadcast();
        this.checkpointSoon();
        return Response.json(out);
      } catch (e: any) {
        return Response.json({ error: e.message || 'Room operation failed.' }, { status: 400 });
      }
    }

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return Response.json({ error: 'Expected a WebSocket upgrade.' }, { status: 426 });
      const token = url.searchParams.get('token') || '';
      const g = await this.ensureLoaded(code);
      if (!g) {
        return Response.json(
          {
            error:
              'That room has expired or does not exist. Create or join a room first (lobby uses /api/room).',
          },
          { status: 404 },
        );
      }
      const me = g.players.find((p: any) => !p.bot && p.token === token && token);
      if (!me) {
        return Response.json(
          { error: 'Your session has ended. Join again.' },
          { status: 401 },
        );
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      this.sockets.add(server);
      this.socketPlayer.set(server, me.id);
      this.send(server, { type: 'hello', revision: this.revision, tick: this.tick, serverTime: Date.now(), ack: this.ackMap(), state: publicState(g) });
      this.startTickLoop();

      server.addEventListener('message', (event: any) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        const playerId = this.socketPlayer.get(server);
        const meNow = playerId
          ? this.game?.players.find((p: any) => p.id === playerId)
          : null;
        if (!meNow) return;
        try {
          if (msg.type === 'ping') {
            this.send(server, { type: 'pong', clientTime: msg.clientTime || 0, serverTime: Date.now() });
          } else if (msg.type === 'input' && msg.input && typeof msg.input === 'object') {
            // v3 netcode: queue only. The next interval tick drains the
            // queue in seq order and broadcasts once. The old code
            // applied the input here and broadcast actions immediately,
            // which could overtake the previous tick's snapshot and made
            // clients see states out of order. Cost: at most one extra
            // tick (50 ms) of action latency — worth it for determinism.
            // command() still drops stale/duplicate seqs at drain time.
            queueInput(this.inputQueue, meNow.id, msg.input);
          } else if (msg.type === 'op' && typeof msg.op === 'string') {
            const out = this.doOp(msg.op, { ...msg, token: msg.token || token });
            if (out.id) this.socketPlayer.set(server, out.id);
            this.revision++;
            this.broadcast();
          } else if (msg.type === 'leave') {
            this.handleLeave(meNow.id);
            this.revision++;
            this.broadcast();
          }
        } catch (e: any) {
          this.send(server, { type: 'error', error: e.message || 'Operation failed.' });
        }
      });

      server.addEventListener('close', () => {
        this.sockets.delete(server);
        const pid = this.socketPlayer.get(server);
        this.socketPlayer.delete(server);
        // Only treat a close as a leave if this player has no other socket.
        if (pid && ![...this.socketPlayer.values()].includes(pid)) {
          this.handleLeave(pid);
          this.revision++;
          this.broadcast();
          if (this.sockets.size === 0) {
            this.stopTickLoop();
            try {
              this.ctx.waitUntil(this.checkpoint(true));
            } catch {
              void this.checkpoint(true);
            }
          }
        }
      });
      server.addEventListener('error', () => {
        this.sockets.delete(server);
        this.socketPlayer.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return Response.json({ error: 'Unknown room endpoint.' }, { status: 404 });
  }
}
