// PitthuRoom — Cloudflare Durable Object: ONE object per room code.
//
// This is the ONLY authoritative multiplayer simulation. It replaces the old
// HTTP-polling sync (client POSTed /api/room every 90ms, server did a full
// D1 SELECT + JSON.parse + UPDATE with revision optimistic locking per
// input, so concurrent players collided with 409s and the game only advanced
// when a request happened to arrive).
//
// New architecture:
//  * Room state lives IN MEMORY in this object (this.game), not in D1.
//  * Clients connect over WebSocket and send inputs fire-and-forget.
//  * A server-side 30 Hz tick (alarm(), every 33 ms) calls advance() and
//    broadcasts the full public state to every connected socket. No client
//    ever waits for a reply to its input, and there is no revision race:
//    inputs are applied serially inside this single object.
//  * D1 is only a backup: the lobby (create/join) is still created in D1
//    by /api/room, this object hydrates from D1 on first use, and it
//    checkpoints back to D1 at most every 10 s / on lobby & match end /
//    when the last socket closes, so a DO eviction can re-hydrate.
//  * Delta updates are future work — for now the tick broadcasts the full
//    publicState(g) (same payload the old poller returned), which is small
//    enough for 2v2–4v4 and far cheaper than a D1 write per input.
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
//   Server -> client: {type:'hello', revision, state}
//   Server -> client: {type:'state', revision, state}
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
import { createInputQueue, queueInput, drainInputs } from '../lib/netcode.js';

const TICK_MS = 33; // ~30 Hz server tick
const IDLE_TICK_MS = 500; // lobby / match: no sim, just keep-alive checks
const CHECKPOINT_MS = 10_000; // at most one D1 checkpoint per 10 s
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
  private alarmScheduled: boolean = false;
  private lastCheckpoint: number = 0;
  private dirty: boolean = false;

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

  // ---- tick & broadcast ----

  private scheduleTick(delayMs: number): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    this.ctx.storage.setAlarm(Date.now() + delayMs).catch(() => {
      this.alarmScheduled = false;
    });
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    if (!this.game || this.sockets.size === 0) {
      // No players left: checkpoint once and stop ticking until someone returns.
      await this.checkpoint(true);
      return;
    }
    const phase = this.game.phase;
    if (phase === 'opening' || phase === 'chase' || phase === 'result') {
      // V2 netcode: inputs are applied ONLY here, at the tick boundary,
      // in per-player seq order — never on WS arrival. Applying on
      // arrival made movement depend on network jitter (two inputs 5 ms
      // apart moved the player by different amounts) and let an action
      // broadcast overtake the previous tick's state.
      for (const { playerId, input } of drainInputs(this.inputQueue)) {
        const pl = this.game.players.find((q: any) => q.id === playerId);
        if (pl) command(this.game, playerId, sanitizeInput(input, this.game, pl));
      }
      this.tick++;
      advance(this.game, Date.now());
      this.revision++;
      this.broadcast();
      await this.checkpoint();
      this.scheduleTick(TICK_MS);
    } else {
      // Lobby / match: nothing to simulate; broadcast only if something changed.
      if (this.dirty) {
        this.dirty = false;
        this.revision++;
        this.broadcast();
        await this.checkpoint();
      }
      this.scheduleTick(IDLE_TICK_MS);
    }
  }

  private broadcast(): void {
    if (!this.game) return;
    const msg = JSON.stringify({
      type: 'state',
      revision: this.revision,
      tick: this.tick,
      serverTime: Date.now(),
      state: publicState(this.game),
    });
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
      g.last = Date.now();
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
        await this.checkpoint();
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
      this.send(server, { type: 'hello', revision: this.revision, tick: this.tick, serverTime: Date.now(), state: publicState(g) });
      this.scheduleTick(TICK_MS);

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
            // V2 netcode: queue only. The next alarm() tick drains the
            // queue in seq order and broadcasts once. The old code
            // applied the input here and broadcast actions immediately,
            // which could overtake the previous tick's snapshot and made
            // clients see states out of order. Cost: at most one extra
            // tick (33 ms) of action latency — worth it for determinism.
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
          if (this.sockets.size === 0) void this.checkpoint(true);
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
