# Pitthu (Seven Stones)

**A 3D multiplayer browser game of Pitthu — the traditional Indian courtyard game also known as Seven Stones / Lagori — rebuilt for the web.**

Two teams face off in a sunlit Indian neighbourhood courtyard. One team knocks down a tower of seven stones and tries to rebuild it, stone by stone, while the other team tries to hit every builder out with the ball before they finish. Play with friends on desktop or mobile, in 2v2 to 4v4 matches, using a 6-character room code. No install, no account — just open the link and play.

> **Portfolio note:** this is a personal project by a beginner game developer learning Unreal Engine and web multiplayer. The game logic, 3D courtyard, characters and netcode were built to learn how a real multiplayer game actually works — including fixing the lag that showed up in the first real playtests (see [Realtime multiplayer](#realtime-multiplayer-websocket--durable-object)).

## What is Pitthu?

Pitthu (also called **Seven Stones** or **Lagori**) is a traditional team game played across India, usually in a street or courtyard. A stack of seven flat stones is piled in the centre. The attacking team (the **Builders**) throws a ball to knock the stones down, then scrambles to rebuild the tower while the defending team (the **Seekers**) tries to hit them out with the ball. If the Builders rebuild all seven stones, they score. If every Builder is hit out first, the Seekers win the round. Teams swap sides each round.

This project keeps those rules, and adds power-ups, distinct characters, and online multiplayer.

## Features

- **Flexible team formats (2v2 to 4v4):** symmetric (`2v2`, `3v3`, `4v4`) or asymmetric (`2v4`, `3v4`) matches. Teams keep their full squad size as they alternate between Attacking (Builders) and Defending (Seekers) each round.
- **Online multiplayer with room codes:** create a room, share the 6-character code, and friends join from any browser. Empty spots can be filled with practice bots.
- **Solo practice mode:** play against bots any time, with no room or connection needed.
- **8 unique courtyard characters:** Aarav, Tara, Kabir, Mira, Aadi, Nila, Dev, and Zoya — each with distinct 3D accessories, custom outfits, skeletal animations (`Idle`, `Run`, `Carry`, `Aim`, `Throw`, `Place`, `Out`, `Celebrate`), and matching HUD portraits.
- **Skill-based stone rebuilding and stationary aiming:**
  - **Opening strike:** the designated striker takes up to 3 stationary shots (0–100% charge) to scatter the 7-stone stack.
  - **Manual pickup and centre stack:** Builders run to loose stones (< 1.05 m) to pick them up, then hold inside the centre circle (< 1.15 m) for 0.65 s to stack each layer back onto the tower.
  - **Smart pass and charge cancel:** Defenders root in place while charging a throw, can cancel a charge at any time (`Q` / right-click / ✕ CANCEL), or aim at a teammate to fire a homing pass caught in stride.
- **Restricted tower crease zone:** an orange perimeter (1.85 m radius) around the centre stone stack slows defenders and dampens close-range point-blank throws, so nobody can camp the tower.
- **6 courtyard power-ups:**
  - **Chappal Dash** — +38% sprint speed and removes the stone-carrying slowdown.
  - **Genda Shield** — a marigold barrier that blocks one direct ball hit or stun burst.
  - **Mirchi Bomb** — detonates a spicy sneeze knockback wave when opponents get close.
  - **Nimbu Pani Fizz** — magnetic stone/ball scoop, 2× faster stone stacking, fast throw charge, and 2-bounce ricochet throws.
  - **Judwaa Split-Ball** — fires a twin-ball V-spread for defenders, or locks two stones at once for builders.
  - **Kathputli Decoy** — deploys an animated clone matching your character and team colours to draw defender fire.
- **Cross-device rendering:** high-DPI WebGL 2 PBR rendering with 2048×2048 soft shadows on modern desktop and mobile browsers, plus automatic WebGL 1 bone-mesh conversion and a 2D/3D Canvas fallback for older integrated graphics.
- **Synth sound effects:** all audio is generated with the Web Audio API — no audio files to download.

## How to play

### The goal

- **Builders (attacking team):** rebuild all 7 stones. You win the round the moment the seventh stone is stacked.
- **Seekers (defending team):** hit every Builder out with the ball before they rebuild the tower. You win the round if time runs out or every Builder is out.
- Teams swap attack/defence each round. First to win the most rounds over 6 rounds (with overtime if tied) wins the match.

### A round, step by step

1. **Opening strike** — the striker stands still, aims, and holds to charge a throw (0–100%). Release to knock the stones down. You get up to 3 attempts.
2. **Chase** — the stones scatter. Builders run to loose stones, pick them up with `E` / **PICK UP**, carry them to the glowing centre circle, and hold `E` / **STACK** to place each stone. Seekers pick up the loose ball and throw it at Builders — a hit takes a Builder out.
3. **Power-ups** spawn on pads around the courtyard during the chase. Walk over one to grab it.
4. **Round end** — the round ends when the tower is rebuilt, all Builders are out, or the 60-second timer runs out. Then teams swap sides.

### Controls

| Action | Desktop (keyboard & mouse) | Mobile / touch |
| :--- | :--- | :--- |
| **Move** | `W A S D` or arrow keys | Left virtual joystick |
| **Aim & charge throw** | Mouse aim + hold & release `Space` / left-click | Hold, drag & release **THROW** pad |
| **Cancel throw charge** | `Q`, `Shift`, `Esc`, or right-click | Slide finger to **✕ CANCEL** |
| **Smart pass (defenders)** | Aim at a teammate + release throw (or press `F`) | Aim at a teammate + release **THROW** |
| **Pick up / stack stone** | Tap `E` near a stone / hold `E` in the centre circle | Tap **PICK UP** / hold **STACK** |
| **Cycle camera mode** | Press `C` (`AUTO` / `ZOOM` / `WIDE`) | Tap the top-right camera button |

## Tech stack

| Layer | Technology |
| :--- | :--- |
| Frontend / game client | Next.js 16 (App Router), React 19, TypeScript |
| 3D rendering | Three.js (WebGL 2 PBR, skeletal animation), with a 2D Canvas fallback |
| Game simulation | Shared deterministic logic in `lib/game.js` — used by practice mode, the server, and the tests |
| Realtime multiplayer | WebSocket + Cloudflare Durable Object (`PitthuRoom`), 30 Hz server tick |
| Lobby & room storage | Cloudflare D1 (SQLite) via Drizzle ORM — lobby only, never per-tick |
| Hosting / runtime | Cloudflare Workers (via the `vinext` + `@cloudflare/vite-plugin` setup) |
| Styling | Tailwind CSS 4, Lucide icons |
| Tests | Plain Node test scripts (no test framework) |

## Architecture

```
Browser (Next.js + Three.js)                Cloudflare
┌────────────────────────────┐              ┌──────────────────────────────────┐
│ app/pittu.tsx              │  WebSocket   │ worker/index.ts                  │
│  • input every 50 ms       │ ───────────► │  routes /ws to the room's        │
│  • renders state at 60 fps │  wss://host  │  Durable Object                  │
│  • dead-reckoning between  │  /ws?code=.. │                                  │
│    server broadcasts       │              │ worker/room-do.ts (PitthuRoom)   │
│                            │  state 30 Hz │  • one object per room code      │
│                            │ ◄─────────── │  • game state in memory          │
│                            │              │  • 30 Hz tick: advance() +       │
│                            │              │    broadcast publicState()       │
│                            │              │  • inputs applied serially,      │
│                            │              │    no D1 write per input         │
└────────────────────────────┘              └──────────────┬───────────────────┘
                                                           │ lobby only
                                                           ▼
                                              D1 (pitthu-rooms-db)
                                              • room code + lobby state
                                              • checkpoint every ≤10 s
```

The important rule: **the Durable Object is the only authoritative simulation.** The lobby HTTP API (`/api/room`) creates and joins rooms, but once a room's Durable Object has loaded it, lobby operations are forwarded to that object. There is exactly one copy of the game state that moves — the one in memory in the Durable Object.

### Realtime multiplayer (WebSocket + Durable Object)

The first deployed version synced multiplayer by **HTTP polling**, and it was laggy with real players. This is what was wrong, and what replaced it:

**The old problem**

- The client sent its input with `POST /api/room` every 90 ms and *waited for the reply* before sending the next one, so real latency was 90 ms + round-trip (often 150–300 ms from India).
- Every input triggered a full D1 database read (whole game state), a simulation step, and a full D1 write — with a revision check. When two players sent at the same time, one of them lost the race and got a `409 "Room is busy"`, then had to retry.
- The game only advanced when a request happened to arrive, and `advance()` threw away any delay over 0.5 s, so delayed polls lost game time and players saw jitter and rubber-banding.

**The fix**

- One `PitthuRoom` Durable Object per room code (`worker/room-do.ts`) holds the game in memory. It accepts WebSocket connections, authenticates them with the same token the lobby issued, and applies inputs serially as they arrive — no database write, no revision race, no 409.
- A server-side **30 Hz tick** (`alarm()`, every 33 ms) calls `advance(game, Date.now())` and broadcasts the full public state to every connected socket, whether or not anyone sent input. The game now moves on its own clock, not on the arrival of client requests.
- The client (`app/pittu.tsx`) sends input every **50 ms (20 Hz), fire-and-forget** — it never waits for a reply. One-shot actions (throw / pass / interact) are only cleared after a successful send, so they survive a dropped connection and fire on reconnect instead of being lost.
- If the socket drops, the client reconnects with exponential backoff (500 ms → 5 s max) and shows the connection status. There is deliberately **no silent fallback to polling** — polling was the bug.
- D1 is now only a backup: the lobby is stored there, the Durable Object hydrates from it on first use, and it checkpoints back at most every 10 s (and on lobby/match end, and when the last player leaves).

**WebSocket protocol** (all messages are JSON):

```text
Client → server:  {"type": "input", "input": {"seq": 42, "round": 0, "mx": 1, "mz": 0,
                    "ax": 1, "az": 0, "interact": false, "charging": false,
                    "charge": 0.65, "action": "throw"}}
Client → server:  {"type": "op", "op": "start" | "config" | "switchTeam" | "lobby" | "leave", ...}
Client → server:  {"type": "leave"} | {"type": "ping"}
Server → client:  {"type": "hello", "revision": 12, "state": {...}}
Server → client:  {"type": "state", "revision": 13, "state": {...}}
Server → client:  {"type": "error", "error": "..."} | {"type": "pong"}
```

Connect with: `wss://<host>/ws?code=XXXXXX&token=<uuid>` (the alias `/api/room/ws` works too). The broadcast state is `publicState(game)` — player tokens are stripped, and it carries a digest checksum.

**What is still full-state, not delta:** each 30 Hz broadcast currently sends the whole public state. That is fine for 2v2–4v4, and it keeps the client simple (it just replaces its state). Sending only the changed fields is on the roadmap.

## Getting started

### Prerequisites

- **Node.js** `>= 20.0.0`
- **pnpm** `>= 9.0.0`
- For deploying: a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and `wrangler` (included in devDependencies)

### Run locally

```bash
pnpm install
pnpm dev        # serves on http://localhost:5173
```

Open the page, pick a character, and either:

- **Practice** — play solo against bots, no setup needed. This works even without any Cloudflare configuration.
- **Create a room** — needs the D1 database configured (see [Deploy](#deploy-to-cloudflare)). Share the 6-character room code with friends; they join from the same deployed URL.

### Run the tests

```bash
pnpm test
```

Individual test suites (plain Node, no dependencies to install first):

```bash
node scripts/test-game.mjs        # Core rules, collisions, power-ups, 2v2..4v4 & asymmetric side swaps
node scripts/test-regressions.mjs # Multi-round simulation, cover rebounds, and state sync checks
node scripts/test-realtime.mjs   # 30 Hz tick + 20 Hz input invariants: no dropped time,
                                  # stale-seq guard, token stripping, WS protocol shape
node scripts/test-assets.mjs     # 3D GLB rig, animation clips, and texture asset verification
```

### Lint

```bash
pnpm lint
```

## Deploy to Cloudflare

The game is built to run on Cloudflare Workers (free tier is enough for small rooms). **Do the steps in this order** — the D1 placeholder is the most common reason a fresh deploy fails.

```bash
# 1. Log in to Cloudflare (opens a browser tab once)
npx wrangler login

# 2. Create the real D1 database for rooms
npx wrangler d1 create pitthu-rooms-db
#    → copy the database_id it prints

# 3. Replace the placeholder ID in vite.config.ts
#    const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";
#    Paste the real database_id there. Until you do this, creating or
#    joining a room fails — the lobby has nowhere to be stored.

# 4. Create the rooms table
npx wrangler d1 migrations apply pitthu-rooms-db

# 5. Deploy (this also deploys the PitthuRoom Durable Object —
#    the binding + migrations tag v1 are declared in vite.config.ts)
npx wrangler deploy
#    (pnpm build only builds the app locally — it does not deploy.)
```

Then open the deployed URL and test with **2 or more real users** (different devices/networks, not just two tabs on the same machine):

1. Player A creates a room and shares the code.
2. Player B joins with the code.
3. Both should see each other in the lobby, the host starts the match, and movement/throws should feel smooth — no rubber-banding, no "Room is busy" errors.
4. If the game shows *"Realtime connection failed — the PitthuRoom Durable Object is not deployed yet"*, the deploy in step 5 did not include the Durable Object binding. Re-check `vite.config.ts` (`durable_objects` + `migrations`) and redeploy.

For local Worker development (with a local D1):

```bash
pnpm start   # wrangler dev with local persistence in .wrangler/state
```

## Project structure

```text
├── app/
│   ├── api/room/route.ts    # Lobby-only HTTP API (create/join/config/start…).
│   │                        # Forwards to the Durable Object once it owns a
│   │                        # room. Per-tick `input` returns 410 — use the WS.
│   ├── globals.css          # Responsive courtyard HUD & menu styling
│   ├── layout.tsx           # Root Next.js layout & metadata
│   ├── page.tsx             # Main entry page
│   └── pittu.tsx            # Game client: HUD, audio synthesizer, input
│                            # controller, WebSocket realtime client (50 ms
│                            # fire-and-forget input, reconnect with backoff)
├── assets/source/           # Blender Python scripts for 3D character,
│                            # courtyard, and sprite generation
├── db/                      # Drizzle ORM schema for the D1 rooms table
├── drizzle/                 # SQL migration for the rooms table
├── lib/
│   ├── game.js              # Shared deterministic game loop, physics, bot
│   │                        # AI, and anti-cheat rules — the authoritative
│   │                        # simulation, used by practice, the server & tests
│   ├── navigation.js        # Courtyard obstacle bounds, swept collision,
│   │                        # and pathfinding waypoints
│   ├── world.js             # Three.js 3D renderer, skeletal animation
│   │                        # mixer, and camera controller
│   └── world-fallback.js    # 2D Canvas sprite fallback renderer
├── public/
│   ├── models/              # 3D GLB character & courtyard models and textures
│   └── portraits/           # 256×256 character avatars and menu hero artwork
├── scripts/                 # Automated gameplay, regression, realtime, and
│                            # asset test suites (see "Run the tests")
├── worker/
│   ├── index.ts             # Worker entry: routes /ws upgrades to the
│   │                        # Durable Object, everything else to Next.js
│   └── room-do.ts           # PitthuRoom Durable Object: in-memory room,
│                            # WebSocket handling, 30 Hz tick, D1 checkpoint
├── cloudflare-env.d.ts      # Env typings (DB, PITTHU_ROOM)
├── vite.config.ts           # Worker config: D1 + Durable Object bindings.
│                            # ⚠️ Replace D1_PLACEHOLDER_ID before deploying.
└── package.json
```

## Known limitations

- **Broadcasts are full-state, not delta.** Every 30 Hz tick sends the whole public game state. Fine for 2v2–4v4, but wasteful at larger scale — delta updates are the next optimisation.
- **No region choice.** A Durable Object lives in one Cloudflare location, chosen when it is first created. Players far from that location will have higher latency than players near it; there is no per-region room selection yet.
- **Rooms expire after 2 hours** of inactivity, and a room's Durable Object checkpoints to D1 at most every 10 seconds — if the object is evicted between checkpoints, up to ~10 seconds of lobby state could be lost (in-match state is rebuilt from the checkpoint + the tick continues from there).
- **Client prediction is visual only.** The client dead-reckons other players between broadcasts for smooth rendering, but the server is authoritative — if your input disagrees with the server, the server wins.
- **No spectator mode, voice chat, or matchmaking.** You join by sharing a room code. Random matchmaking and replays are not built.
- **The 3D models are generated assets** (see `assets/source/` for the Blender scripts that made them). They are checked into `public/models/` and `public/portraits/`.

## Roadmap

- [ ] Delta state broadcasts (send only what changed each tick)
- [ ] Client-side input prediction + server reconciliation, so your own movement feels instant even on high ping
- [ ] Latency / ping display in the HUD
- [ ] Spectator mode for finished or full rooms
- [ ] Rematch button (one click, same room, same players)
- [ ] Sound toggle per effect, and a mute-all shortcut
- [ ] More power-ups and a second courtyard map

## Contributing

This is a learning project, so contributions that teach something are welcome:

1. Fork the repo and create a branch for your change.
2. Keep the game simulation in `lib/game.js` — the client, the server, and the tests all share it, so a rule change in one place changes it everywhere.
3. Add or extend a test in `scripts/` for any gameplay change, and run `pnpm test` before opening a pull request.
4. Don't commit secrets, and don't change the D1 placeholder ID in `vite.config.ts` to a real database ID — that value belongs in your own deployment, not in the repo.

Found a bug? The most useful report is: what you did, what you expected, what happened, how many players were in the room, and whether you were on desktop or mobile.
